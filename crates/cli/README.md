# Command-line launcher

Run from the repository root, or pass its absolute location with `--project`.

```sh
cargo run -p pcl-cli -- catalog
cargo run -p pcl-cli -- --root /path/to/.minecraft install 1.20.1
cargo run -p pcl-cli -- list
cargo run -p pcl-cli -- plan '1.20.1' --player Player --memory 8
cargo run -p pcl-cli -- run '1.20.1' --player Player --memory 8
cargo run -p pcl-cli -- --project /path/to/PCL-RH --root /path/to/.minecraft list
```

`catalog` lists official versions as JSON. `install` downloads a vanilla version
into the selected game root, validates SHA-1 hashes, reuses verified complete
files, and prints its result as JSON. Progress is written to stderr. Existing
version directories are never overwritten. Some legacy versions are unsupported.
Java must be installed separately.

`list` and `plan` print JSON. `plan` validates installed jars, asset objects,
logging configuration and Java, then refreshes extracted Linux natives; it does
not start Minecraft. `run` starts the Java process directly, writes stdout/stderr
to `.minecraft/.pcl-linux/logs/<instance>.log`, waits, and returns its exit code.
Version names with spaces should be shell quoted.

The CLI supports existing installations and offline player names (3–16 ASCII
letters, digits or underscores). Missing dependencies produce a bounded error
listing. The CLI does not manage Microsoft accounts or install mod loaders. Java is selected from project runtimes, `JAVA_HOME`, `PATH`, and
`/usr/lib/jvm`, preferring the lowest installed major meeting the version's
requirement. Forge/NeoForge require an exact Java major match to avoid silently running
older loaders on an incompatible newer JVM. Projects may keep runtimes under `PCL-Linux/runtime/bin/java` or
`runtime/bin/java`, with `runtime-21` and `runtime-25` also recognized.

The core merges inherited metadata with a cycle guard, replaces inherited Maven
library versions by group/artifact/classifier, applies Linux rules and feature
flags, extracts both modern native artifacts and older native classifiers, and
rejects traversal and symlink escapes in metadata paths. Launch metadata is
executable configuration: use trusted local version descriptors and mod jars.
