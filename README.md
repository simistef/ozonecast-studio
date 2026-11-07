# OzoneCast Studio — Icecast Real-Time Listener Telemetry & Analytics

Broadcast-grade Icecast 2.4 / KH real-time listener monitoring, MaxMind GeoIP world/Europe map, User-Agent/device classification (including Apple HomePod mini `AudioAccessory5,1`), and SQLite historical concurrency & session tracking for `https://live.ozone.fm:8443/admin/listclients.xsl?mount=/listen`.

---

## Deploying on Synology NAS DS720+ (DSM 7.2 Container Manager)

Your Synology DS720+ (`x86_64` Intel Celeron J4125) runs this container natively and connects directly to `https://live.ozone.fm:8443` every 10 seconds without any proxy restrictions.

### Step 1: Create the Project Folder on Your Synology NAS

1. Open **File Station** in Synology DSM.
2. Inside your `docker` shared folder, create a subfolder named `ozonecast` (full path on DSM: `/volume1/docker/ozonecast`).
3. Upload the project files (`Dockerfile`, `docker-compose.yml`, `package.json`, `server.js`, `src/`, and `public/`) into `/volume1/docker/ozonecast`.

### Step 2: Build & Run via Synology Container Manager (GUI)

1. Open **Container Manager** in Synology DSM.
2. Go to **Project** in the left sidebar and click **Create**.
3. Fill in the Project details:
   - **Project name**: `ozonecast-studio`
   - **Path**: Select `/docker/ozonecast`
   - **Source**: Choose **Use existing docker-compose.yml**
4. Click **Next**, review the configuration, and click **Done** to build and start the container.

### Alternative Step 2: Build & Run via SSH on DS720+

If you have SSH enabled on your DS720+:

```bash
cd /volume1/docker/ozonecast
sudo docker compose up -d --build
```

### Step 3: Open the Dashboard

Open your browser on any device on your network and visit:

```text
http://<YOUR-SYNOLOGY-NAS-IP>:3080
```

- **Live Polling**: The container automatically polls `https://live.ozone.fm:8443/admin/listclients.xsl?mount=/listen` every 10 seconds (`SOURCE_MODE=live`).
- **Persistent SQLite History**: All historical listener counts, 24-hour/all-time peaks, and per-IP session logs are saved to `/volume1/docker/ozonecast/data/ozonecast.sqlite`.
- **Optional HTTPS Reverse Proxy**: In Synology DSM, go to **Control Panel → Login Portal → Advanced → Reverse Proxy** to map a custom subdomain (e.g. `https://stats.ozone.fm`) to `http://localhost:3080`.
