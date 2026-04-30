# Study Chat

## Deployment Guide

> All development happens on the `migration` branch. Make sure you are on the `migration` branch before making any changes.

### Frontend Deployment

1. **Build and push from your local machine:**

   ```bash
   make deploy-client
   ```

   Run this from the project root. It builds the client and pushes the `dist/` to the **study-chat-dist** repository.

2. **Deploy via Plesk:**

   - Log into Plesk and pull the latest from the **study-chat-dist** Git repository.
   - Go to the **Node.js** tab, run `npm install`, then restart the app.

### Backend Deployment

1. **Push server updates:**

   Commit and push changes to the main repository (where the `server/` directory lives) on the `migration` branch.

2. **Deploy via Plesk:**

   - SSH into the server or use the Plesk Git interface.
   - Navigate to the backend directory.
   - Pull the latest changes:

     ```bash
     git pull
     ```

   - Restart the server if needed (depending on your setup).

### Notes

- **Frontend and backend are deployed separately:**
  - Frontend → `study-chat-dist` repo → pulled into `httpdocs`
  - Backend → main repo (`migration` branch) → pulled on server
- Always rebuild (`npm run build`) before pushing frontend updates.
- If something doesn't update on the site, try clearing cache or forcing a reload.
- Always work on the `migration` branch in the study-chat GitHub repository.
