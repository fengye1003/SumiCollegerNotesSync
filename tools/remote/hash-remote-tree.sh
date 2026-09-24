#!/bin/bash
D=/mnt/shared/PlayFiles/Documents/Concepts/Demo/Demo
cd "$D" || exit 1
find . -name '*.concepts' -type f -print0 | sort -z | xargs -0 sha256sum
