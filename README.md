# cockpit-ports

A read-only **Ports** page for [Cockpit](https://cockpit-project.org/). It shows every port on your server and what's using it, across services, processes, and Podman containers (rootful and rootless).

## Features

- Every listening TCP/UDP port, with the owning systemd service or process
- Podman port mappings (`8080 → app:80/tcp`) for root **and** every rootless user
- **Reserved** ports: mappings held by stopped containers
- **Conflicts**: a stopped container's port that something else is now using
- Search by port (`1234`), range (`1234-1500`), or text (`nginx`, `myuser`, a container name)
- Free-port lookup in any range
- Sorting, rows-per-page, and light/dark mode that follows Cockpit

It is strictly **read-only**. It only runs `ss`, `ps`, `podman ps`, and `systemctl list-sockets`.

## Requirements

- Cockpit (tested on Ubuntu 24.04)
- `iproute2` (`ss`), which is installed by default on most distros
- Podman (optional, only needed for container mappings)

## Install

```bash
git clone https://github.com/tinescast/cockpit-ports.git
cd cockpit-ports
bash install.sh                 # just for your user
# or
sudo bash install.sh --system   # for all users
```

Then reload Cockpit and open **Ports** in the sidebar.

To install by hand, copy the `ports/` folder to `~/.local/share/cockpit/ports` (for your user) or `/usr/share/cockpit/ports` (system-wide).

## Full visibility

Switch Cockpit to **Administrative access** (top bar). Without it, you'll still see all ports and your own containers, but processes and containers owned by other users won't be identified.

## Uninstall

```bash
bash install.sh --uninstall                 # user install
sudo bash install.sh --system --uninstall   # system install
```

## License

MIT, see [LICENSE](LICENSE).
