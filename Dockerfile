FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["sh", "-c", "npm run migrate && npm start"]
