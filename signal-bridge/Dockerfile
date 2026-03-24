FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.cjs ./

EXPOSE 3002

CMD ["npm", "start"]
