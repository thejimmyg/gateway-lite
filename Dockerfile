FROM node:alpine as certbot
RUN apk update && apk add certbot && rm -rf /var/cache/apk/*

FROM certbot as builder
RUN mkdir /app
WORKDIR /app
COPY package.json /app
COPY package-lock.json /app
RUN npm install --only=prod

FROM certbot
COPY --from=builder /app /app
WORKDIR /app
EXPOSE 80
EXPOSE 443
ENV NODE_PATH=/app/node_modules
ENV PORT=80
ENV HTTPS_PORT=443
ENV NODE_ENV=production
ENV PATH="${PATH}:/app/node_modules/.bin"
COPY bin/ /app/bin/
ENTRYPOINT ["node", "bin/gateway-lite.js"]
CMD []
