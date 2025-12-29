# Use official Node.js 18 Slim Image (More reliable than Alpine)
FROM node:18-slim

# Set Working Directory
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install Dependencies (Production only) with verbose logging
RUN npm install --omit=dev --loglevel=verbose

# Copy the rest of the application code
# This includes 'public/' (frontend build) and 'src/' (backend code)
COPY . .

# Expose the port used by Cloud Run
ENV PORT=8080
EXPOSE 8080

# Start the application
CMD ["node", "index.js"]
