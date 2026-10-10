# Local GTK compatibility patch

Source: the crates.io glib 0.18.5 package, retained with its original licenses.

The only source change is in src/variant_iter.rs: the C string out-pointer is
mutable and is passed as &mut p. This backports the upstream correction in
https://github.com/gtk-rs/gtk-rs-core/pull/1343 for RUSTSEC-2024-0429.

Tauri's GTK 3 dependencies require glib 0.18, so upgrading this one crate to
glib 0.20 would not satisfy their API/version requirements. The optimized
regression test is in src-tauri/tests/glib_regression.rs.

Remove this override when Tauri's GTK dependency includes the upstream fix.
