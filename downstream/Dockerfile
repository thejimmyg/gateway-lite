FROM node:alpine as base

FROM base as builder
RUN mkdir /app
WORKDIR /app
COPY package.json /app
COPY package-lock.json /app
RUN npm install

FROM base
COPY --from=builder /app /app
WORKDIR /app
ENV NODE_PATH=/app/node_modules
ENV NODE_ENV=production
ENV PATH="${PATH}:/app/node_modules/.bin"
ENV PORT=8000
EXPOSE 8000
COPY bin/ /app/bin/
ENTRYPOINT ["node", "bin/downstream.js"]
CMD = []
