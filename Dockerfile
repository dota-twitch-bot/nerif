FROM node:lts-alpine3.15
RUN apk add git
RUN apk add subversion
WORKDIR /app
COPY package.json .
COPY .env .
RUN npm install
COPY src src
CMD ["node", "src/app.js"]