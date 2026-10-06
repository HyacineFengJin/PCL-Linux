# Included components

The experimental launcher integration includes the supplied Extension 0.6, Mod Creator 0.4, Mod Porter 0.5.1 and shared Pi runtime v7 modules. `SOURCES.json` records their versions and the included Python tool hashes.

The Maker and Porter modules retain their original MIT license notices in `runtime/vendor/maker/LICENSE` and `runtime/vendor/porter/LICENSE`. The Pi SDK and its dependencies retain their own package licenses and are installed from the pinned npm lockfile.

The launcher adapters reuse these modules for declarations, source generation, source ownership and limited migration proposals. Standalone lab servers, demonstrations and testing records are not part of the desktop integration.
