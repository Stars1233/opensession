#!/bin/sh
# SSH_ASKPASS helper: answers ssh's password prompt from the environment so a
# sandbox login password never appears in argv. Pair with
# SSH_ASKPASS_REQUIRE=force.
printf %s "${OPENSESSION_SSH_PASSWORD:-}"
