FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . ./

ARG PORT=3000
ENV NODE_ENV=production \
    PORT=${PORT}
EXPOSE ${PORT}

CMD ["node", "index.js"]
