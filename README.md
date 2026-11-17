# OpenCloud SID Player - demo site

This branch is the demo published with GitHub Pages: the SID Library as it
looks in OpenCloud, with ten tunes and no server. The app itself is on the
`main` branch.

`_demo/` is the source of the site, and `_demo/library/` its tunes; everything
else here is its build. Each release rebuilds it from the tagged code, with

```
_demo/build.sh <checkout of main> <output folder>
```

and replaces the previous build at the root of this branch. Run without
arguments, the same script builds from `main` as committed straight into this
checkout, for trying a change by hand.
