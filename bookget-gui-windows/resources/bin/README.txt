Put runtime binaries here before packaging:

1) bookget-core.exe
   - Required.
   - Source: https://github.com/deweizhu/bookget/releases (Windows x64 / arm64)

2) dezoomify-rs.exe
   - Optional but recommended for IIIF large-tile workflows.
   - Source: https://github.com/lovasoa/dezoomify-rs/releases

3) config.ini (optional)
   - Optional local runtime tuning.

At runtime, the app will read binaries from:
- Dev mode: resources/bin/
- Packaged mode: <App>/resources/bin/
