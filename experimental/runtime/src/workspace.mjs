import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './errors.mjs';

export async function readCheckedTextHandle(handle) {
  const stat = await handle.stat();
  // Atomic replacement can unlink the old inode after it was safely opened.
  // Its descriptor is still a valid immutable snapshot; only >1 means hardlinks.
  check(stat.isFile() && stat.nlink <= 1 && stat.size <= 1_000_000,
    'UNSAFE_PATH', 'Expected a regular file without multiple links below 1 MB');
  return handle.readFile('utf8');
}

// Defense-in-depth path checks for trusted host tools. This is NOT an OS sandbox.
export class Workspace {
  constructor(root) { this.root = path.resolve(root); }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    check(!(await fs.lstat(this.root)).isSymbolicLink(), 'UNSAFE_PATH', 'Workspace cannot be a symlink');
    this.root = await fs.realpath(this.root);
    return this;
  }
  async resolve(relative, { parents = false } = {}) {
    check(typeof relative === 'string' && relative.length > 0 && relative.length < 1024,
      'UNSAFE_PATH', 'Expected a nonempty relative path');
    check(!path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0'),
      'UNSAFE_PATH', 'Absolute and platform-ambiguous paths are forbidden');
    const parts = relative.split('/');
    check(parts.every(p => p && p !== '.' && p !== '..'), 'UNSAFE_PATH', 'Traversal and empty segments are forbidden');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const parent = i < parts.length - 1;
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (parent && parents) {
          try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          stat = await fs.lstat(current);
        } else if (parent) throw error;
      }
      if (stat) {
        check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Symlinks are forbidden in job workspaces');
        check(parent ? stat.isDirectory() : stat.isFile(), 'UNSAFE_PATH', 'Expected directory ancestors and a regular file');
      }
    }
    return current;
  }
  async write(relative, content) {
    check(typeof content === 'string' && Buffer.byteLength(content) <= 1_000_000,
      'INVALID_CONTENT', 'Expected text below 1 MB');
    return this.writeBytes(relative, Buffer.from(content, 'utf8'));
  }
  async writeBytes(relative, content) {
    check(content instanceof Uint8Array && content.byteLength <= 1_000_000,
      'INVALID_CONTENT', 'Expected bytes below 1 MB');
    const target = await this.resolve(relative, { parents: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return { path: relative, bytes: Buffer.byteLength(content) };
  }
  async read(relative) {
    const target = await this.resolve(relative);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { path: relative, content: await readCheckedTextHandle(handle) };
    } finally { await handle.close(); }
  }
}
