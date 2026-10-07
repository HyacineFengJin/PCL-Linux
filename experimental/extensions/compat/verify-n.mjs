/** Developer-only, Linux ABI experiment against pinned public SDK source.
 * Nothing calls this from the launcher. There is no unsandboxed fallback. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { N_SDK_PROBE } from '../src/compatibility.mjs';

if (process.platform !== 'linux' || process.argv.length !== 5)
  throw new Error('Usage on Linux: node verify-n.mjs <dotnet-10> <trusted-pinned-sdk-source> <private-work-root>');
const dotnet = path.resolve(process.argv[2]), sdk = path.resolve(process.argv[3]);
const base = path.resolve(process.argv[4]);
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = path.join(sdk, 'examples/HelloPlugin');
const sampleHash = '7a83b927435e42ab04ccb47786be3d73c94d13745639ddc8038020477f131622';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(path.join(sample, 'HelloHostModule.cs'))), sampleHash,
  'The original pinned Hello source must not be changed.');
await mkdir(base, { recursive: true, mode: 0o700 });
const work = await mkdtemp(path.join(base, 'n-abi-'));
const artifacts = path.join(work, 'artifacts'), app = path.join(work, 'app');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(work, 'Build.props'), `<Project><PropertyGroup>
<Version>${N_SDK_PROBE.version}</Version><AssemblyVersion>0.2.5.0</AssemblyVersion><FileVersion>0.2.5.0</FileVersion>
<Deterministic>true</Deterministic><EnableNETAnalyzers>false</EnableNETAnalyzers>
</PropertyGroup></Project>\n`);
await writeFile(path.join(work, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>\n');
await writeFile(path.join(work, 'HelloSample.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
<TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings>
<LangVersion>14.0</LangVersion><AssemblyName>HelloPlugin</AssemblyName><EnableDefaultCompileItems>false</EnableDefaultCompileItems>
</PropertyGroup><ItemGroup><Compile Include="${xml(path.join(sample, 'HelloHostModule.cs'))}" />
<ProjectReference Include="${xml(path.join(sdk, 'src/PCL.N.Plugin.Sdk/PCL.N.Plugin.Sdk.csproj'))}" />
</ItemGroup></Project>\n`);
const buildEnv = { ...process.env, DOTNET_CLI_HOME: path.join(work, 'cli'),
  NUGET_PACKAGES: path.join(work, 'nuget'), DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  TMPDIR: work, MSBUILDDEBUGPATH: work };

function run(command, args, { input = '', env = buildEnv, timeout = 60000, limit = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let size = 0, out = '', err = '', failure;
    const stop = message => { failure ??= new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('Probe subprocess exceeded its deadline.'), timeout);
    for (const [stream, append] of [[child.stdout, chunk => out += chunk], [child.stderr, chunk => err += chunk]])
      stream.on('data', bytes => { size += bytes.length; if (size > limit) stop('Probe subprocess exceeded its output limit.'); else append(bytes.toString('utf8')); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Probe subprocess exited ${code}: ${err.slice(0, 2000)} ${out.slice(-2000)}`));
      else resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const buildArgs = ['-c', 'Release', '-m:1', '-nr:false', '--artifacts-path', artifacts,
  '--configfile', path.join(work, 'NuGet.Config'), '-p:UseSharedCompilation=false',
  `-p:PclNSdkRoot=${sdk}`, `-p:DirectoryBuildPropsPath=${path.join(work, 'Build.props')}`,
  '-p:IsAotCompatible=false', '-p:IsTrimmable=false', '-p:EnableTrimAnalyzer=false', '-p:NuGetAudit=false'];
for (const project of [path.join(here, 'n-probe/NProbe.csproj'), path.join(work, 'HelloSample.csproj')]) {
  const log = await run(dotnet, ['build', project, ...buildArgs]);
  await writeFile(path.join(work, path.basename(project) + '.log'), log);
}
await mkdir(app);
for (const name of ['NProbe', 'HelloSample']) {
  const directory = path.join(artifacts, 'bin', name, 'release');
  for (const file of await readdir(directory))
    if (/\.(dll|json)$/.test(file)) await copyFile(path.join(directory, file), path.join(app, file));
}
const sandbox = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
  '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
  '--ro-bind', path.dirname(dotnet), '/dotnet', '--ro-bind', app, '/app', '--ro-bind', sample, '/sample',
  '--tmpfs', '/tmp', '--tmpfs', '/fixture-data', '--proc', '/proc', '--dev', '/dev',
  '--setenv', 'DOTNET_CLI_HOME', '/tmp', '--setenv', 'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'false',
  '--setenv', 'DOTNET_CLI_TELEMETRY_OPTOUT', '1', '--chdir', '/tmp', '--'];
// Verify the exposed filesystem and network namespace before running a plugin.
await run('bwrap', [...sandbox, '/usr/bin/python3', '-c', `import pathlib,socket
assert not pathlib.Path('/home').exists() and not pathlib.Path('/data').exists()
assert not pathlib.Path('/etc').exists()
assert sorted(p.name for p in pathlib.Path('/sys/class/net').glob('*')) == []
try:
 socket.create_connection(('1.1.1.1',443),timeout=1)
 raise AssertionError('Network unexpectedly available')
except OSError: pass
try:
 pathlib.Path('/app/write-test').write_text('x')
 raise AssertionError('Plugin input unexpectedly writable')
except OSError: pass
`], { env: {}, timeout: 10000 });
const command = 'dev.muxue.hello.say-hello';
async function probe(requests) {
  const output = await run('bwrap', [...sandbox, '/dotnet/dotnet', '/app/PclRh.NCompatibilityProbe.dll',
    '/app/HelloPlugin.dll', '/sample/plugin.json', '/sample/locales'], {
    input: requests.map(v => JSON.stringify(v) + '\n').join(''), env: {}, timeout: 10000, limit: 128 * 1024,
  });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, requests.length);
  return replies;
}
const results = [];
for (const culture of ['zh-CN', 'en-US']) {
  const replies = await probe([
    { operation: 'initialize', culture, grants: ['pcl.commands', 'pcl.settings-pages'] },
    { operation: 'initialize', culture, grants: ['pcl.commands', 'pcl.settings-pages'] },
    { operation: 'invoke', command: 'not-registered' },
    { operation: 'invoke', command }, { operation: culture === 'zh-CN' ? 'revoke' : 'shutdown' },
    { operation: 'invoke', command },
  ]);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].result.sdkAssemblyVersion, '0.2.5.0');
  const projection = replies[0].result.projection;
  assert.equal(projection.commands[0].id, command);
  assert.equal(projection.settingsPages[0].title, culture === 'zh-CN' ? '你好插件' : 'Hello Plugin');
  assert.equal(replies[1].ok, false);
  assert.equal(replies[2].ok, false);
  assert.equal(replies[3].result.projection.logs[0].message, 'Hello from the sample plugin.');
  assert.equal(replies[4].result.state, 'stopped');
  assert.deepEqual(replies[4].result.projection.commands, []);
  assert.deepEqual(replies[4].result.projection.settingsPages, []);
  assert.equal(replies[5].ok, false);
  results.push({ culture, replies });
}
for (const grants of [[], ['pcl.commands'], ['pcl.settings-pages']]) {
  const replies = await probe([{ operation: 'initialize', culture: 'en-US', grants }, { operation: 'invoke', command }]);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].result.state, 'failed');
  assert.deepEqual(replies[0].result.projection.commands, []);
  assert.deepEqual(replies[0].result.projection.settingsPages, []);
  assert.equal(replies[1].ok, false);
  results.push({ grants, replies });
}
assert.equal(sha(await readFile(path.join(sample, 'HelloHostModule.cs'))), sampleHash);
await writeFile(path.join(work, 'results.json'), JSON.stringify({ sdk: N_SDK_PROBE, sampleHash, results }, null, 2) + '\n');
console.log('PASS: original N Hello ABI, command execution, zh-CN/en-US descriptors, denied grants, cleanup and namespace isolation.');
