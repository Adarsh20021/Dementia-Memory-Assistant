# Dev-mode container for the client (production static build comes in Phase 6).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV API_URL=http://server:4000
EXPOSE 5173
CMD ["npm", "run", "dev"]
