FROM node:alpine as certbot
RUN apk update && apk add certbot && rm -rf /var/cache/apk/*

FROM certbot as builder
RUN mkdir /app
WORKDIR /app
COPY package.json /app
COPY package-lock.json /app
RUN npm install

FROM certbot
COPY --from=builder /app /app
WORKDIR /app
EXPOSE 8000
EXPOSE 3000
ENV NODE_PATH=/app/node_modules
ENV PORT=8000
ENV DEFAULT_DOMAIN=www.example.com
ENV HTTPS_PORT=3000
ENV NODE_ENV=production
ENV PATH="${PATH}:/app/node_modules/.bin"
COPY bin/ /app/bin/
ENTRYPOINT ["node", "bin/gateway-lite.js"]
CMD []
