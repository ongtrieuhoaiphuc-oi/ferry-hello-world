FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=20128 HOSTNAME=0.0.0.0 DATA_DIR=/app/data
WORKDIR /app
RUN npm config set update-notifier false && npx --yes omniroute@latest --version
COPY package.json ./
EXPOSE 20128
VOLUME ["/app/data"]
CMD ["npx", "--yes", "omniroute@latest"]
