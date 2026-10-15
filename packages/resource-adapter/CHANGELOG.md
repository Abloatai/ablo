# Changelog

## 0.1.2

### Patch Changes

- @abloatai/transaction@0.66.15

## 0.1.1

### Protected native workspaces

The Linux filesystem and Git adapter is now distributed as an installable
archive with Ablo 0.66.14. The archive pins the matching transaction SDK and
includes the compiled supervisor entry point and Python implementation.
Release assets include SHA-256 checksums for both packages.

The adapter enforces claims and read versions before publishing native file
changes and Git refs. Installation requires the documented trusted Linux
supervisor and persistent state; existing runners remain unchanged until
explicitly configured.
