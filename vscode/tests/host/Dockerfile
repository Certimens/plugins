# The throwaway environment of `make test-host`: a real VS Code needs a display, even to run a
# suite — it is an Electron application. xvfb gives it one that goes nowhere, and everything the
# editor needs is installed here rather than on the machine.
#
# The image is thrown away with one command (`make test-host-clean`), and the agent is mounted
# read-only at launch: nothing from this repository enters the image.
FROM node:22-bookworm-slim

# The libraries Electron loads on startup. Without one of them, the editor closes straight away
# naming the missing .so.
# dbus: Electron looks for a bus on startup and spits out an error per attempt when it finds
# none. A throwaway session bus (dbus-run-session, below) changes nothing to the result but
# keeps the log readable — a suite whose output is drowned ends up unread.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth dbus ca-certificates \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgtk-3-0 libgbm1 libasound2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# The downloaded editor lives in a volume: without it, every run would fetch it again.
ENV VSCODE_TEST_CACHE=/cache
# The agent is mounted read-only: everything the editor writes goes elsewhere.
ENV VSCODE_TEST_USER_DATA=/tmp/user-data
ENV VSCODE_TEST_EXTENSIONS=/tmp/extensions

WORKDIR /agent
CMD ["dbus-run-session", "--", "xvfb-run", "-a", "npm", "run", "test:host"]
