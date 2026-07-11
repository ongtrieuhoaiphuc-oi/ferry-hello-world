FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=20128 HOSTNAME=0.0.0.0 DATA_DIR=/app/data
WORKDIR /app
COPY package.json ./
# Install OmniRoute into the image at build time so runtime start needs no network fetch.
RUN npm config set update-notifier false \
  && npm install omniroute@latest \
  && npm cache clean --force
EXPOSE 20128
VOLUME ["/app/data"]
CMD ["npx", "omniroute"]
