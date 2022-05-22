FROM node:lts-alpine3.15
WORKDIR /app
RUN apk add git
RUN apk add subversion
COPY . .
RUN npm install
CMD ["node", "app.js"]