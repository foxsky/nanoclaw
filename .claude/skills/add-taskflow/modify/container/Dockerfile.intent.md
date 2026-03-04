# Dockerfile Modifications

Add build tools for native modules (better-sqlite3) before `RUN npm install`:

```dockerfile
RUN apt-get update && apt-get install -y make g++ && rm -rf /var/lib/apt/lists/*
```
