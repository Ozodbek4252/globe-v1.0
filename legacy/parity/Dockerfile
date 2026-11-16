# Headless Chromium + Playwright for the legacy-vs-new screenshot comparison.
# The base image bundles the browsers, so nothing is installed on the host.
# The Playwright version here must match package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /opt/parity
COPY package.json ./
RUN npm install --no-audit --no-fund
