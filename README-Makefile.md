# How to Use the Makefile

Run all commands from the **project root** (`study-chat/`).

To see a short list of targets:

```bash
make help
# or just
make
```

---

## Quick reference

| Target   | Usage                          | Description                          |
|----------|---------------------------------|--------------------------------------|
| **server** | `make server` or `make server BOTS="Sid Vivian Jae"` | Start the backend (optional bot list) |
| **client** | `make client`                   | Start the frontend (Vite dev)        |
| **clean**  | `make clean`                    | Remove `server/logs`                 |
| **help**   | `make help`                     | Show this help                      |

---

## Run the server

```bash
make server
```

Starts the backend (Node) from `server/`. Default port is usually 3001.

To pin which bots are in the call, pass bot names:

```bash
make server BOTS="Sid Vivian Jae"
```

---

## Run the client

```bash
make client
```

Starts the Vite dev server for the frontend from `client/`. Use a separate terminal from the server.

---

## Clean

```bash
make clean
```

Removes the `server/logs/` directory (run log files).

---

## Typical workflow

1. **Terminal 1 — backend**
   ```bash
   make server
   # or with fixed cast:
   make server BOTS="Sid Vivian Jae"
   ```

2. **Terminal 2 — frontend**
   ```bash
   make client
   ```

3. **(Optional)** Clear logs when you want:
   ```bash
   make clean
   ```
