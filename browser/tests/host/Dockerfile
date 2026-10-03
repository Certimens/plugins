# The throwaway environment of `make test-host`: an extension only loads in a Chromium with a
# display, and Chromium asks for a score of system libraries. They are installed here rather
# than on the machine, and the image is thrown away with one command (`make test-host-clean`).
#
# The agent is mounted read-only at launch: nothing from this repository enters the image, and
# nothing from this container comes out of it.
FROM node:22-bookworm-slim

# What Chromium loads on startup, plus xvfb for the display that goes nowhere.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth ca-certificates fonts-liberation \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libgtk-3-0 libgbm1 \
        libasound2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libpango-1.0-0 libxshmfence1 libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# Playwright's Chromium lives in a volume: without it, every run would download it again.
ENV PLAYWRIGHT_BROWSERS_PATH=/browsers

WORKDIR /agent
# The browser version is the one package-lock.json pins, not the latest one online.
CMD ["sh", "-c", "npx --no-install playwright install chromium && xvfb-run -a npm run test:host"]
