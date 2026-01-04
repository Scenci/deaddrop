FROM rust:1.75-bookworm

# Install dependencies
RUN apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    nodejs \
    npm

# Install Tauri CLI
RUN cargo install tauri-cli

WORKDIR /app

# Copy project
COPY . .

# Install npm dependencies
RUN npm install

# Build
CMD ["cargo", "tauri", "build"]