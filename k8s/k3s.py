"""k3s in one container, driven by the Docker SDK: no kind, k3d or kubectl needed on the host.

Run from the project root:

    uv run k8s/k3s.py up [--server pg16|pgrust|both]   # cluster + local images + the databases, wait until ready
    uv run k8s/k3s.py status                            # pods, services, host ports
    uv run k8s/k3s.py down                              # remove the container and its state

Or from Python; the pgvector notebook does this for SERVER="k3s-pg16" / "k3s-pgrust":

    from k3s import up
    up(["pg16"])

What happens in `up`:
  1. `rancher/k3s` starts as a privileged container (`pgbench-k3s`) with tmpfs on /run and /var/run,
     the API server on host port 6445 and the two NodePorts on 5438 (pg16) and 5439 (pgrust).
     The host kubeconfig lands in out/k3s/kubeconfig.yaml (`KUBECONFIG=out/k3s/kubeconfig.yaml kubectl get pods`).
  2. Images that exist in the local Docker cache are streamed in with `docker save` and imported
     into the node's containerd (`ctr images import`), so nothing is pulled twice; anything
     missing locally, k3s pulls itself.
  3. The manifests (pg16.yaml, pgrust.yaml) are dropped into k3s's auto-deploy directory,
     /var/lib/rancher/k3s/server/manifests, which k3s applies on its own: no kubectl call needed.
  4. Waits for the pods to be ready and for Postgres to answer on the host port.

Compared with k3d this is the same node image and the same k3s, minus k3d's load-balancer
container, multi-node support and CLI; the whole thing is ~150 lines of plain Python.
"""

import argparse
import io
import pathlib
import sys
import tarfile
import time

import docker.errors
import psycopg

import docker

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = ROOT / "out" / "k3s"  # kubeconfig.yaml and the image tars live here
NAME = "pgbench-k3s"
K3S_IMAGE = "rancher/k3s:v1.35.5-k3s1"
API_PORT = 6445  # host port for the API server (6443 is what Docker Desktop's own Kubernetes takes)
MANIFEST_DIR = "/var/lib/rancher/k3s/server/manifests"
KUBECTL = ["kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml"]  # inside the node

SERVERS = {
    "pg16": {
        "manifest": "pg16.yaml",
        "image": "sqlalchemy-pgvector-db:pg16",
        "node_port": 30016,
        "host_port": 5438,
    },
    "pgrust": {
        "manifest": "pgrust.yaml",
        "image": "malisper/pgrust:v0.2",
        "node_port": 30018,
        "host_port": 5439,
    },
}


# -------------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------------
def _exec(node, cmd: list[str], check: bool = True) -> str:
    code, out = node.exec_run(cmd)
    text = out.decode(errors="replace")
    if check and code != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({code}):\n{text}")
    return text


def _put_files(node, directory: str, files: dict[str, bytes]) -> None:
    """Copy in-memory files into a directory inside the container (the SDK only speaks tar)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
    node.put_archive(directory, buf.getvalue())


def _wait(what: str, ok, timeout: float) -> None:
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        if ok():
            print(f"  {what} after {time.perf_counter() - t0:.0f}s")
            return
        time.sleep(1)
    raise TimeoutError(f"{what}: still not there after {timeout:.0f}s")


def _node(client: docker.DockerClient):
    try:
        return client.containers.get(NAME)
    except docker.errors.NotFound:
        return None


# -------------------------------------------------------------------------------
# up / down / status
# -------------------------------------------------------------------------------
def up(servers: list[str] | None = None) -> dict[str, str]:
    """Start (or reuse) the cluster and deploy `servers`; returns {server: plain postgresql:// DSN}."""
    servers = servers or list(SERVERS)
    client = docker.from_env()
    STATE.mkdir(parents=True, exist_ok=True)

    node = _node(client)
    if node is None:
        print(f"starting {K3S_IMAGE} as {NAME} ...")
        node = client.containers.run(
            K3S_IMAGE,
            ["server", "--disable=traefik", "--disable=metrics-server"],
            name=NAME,
            detach=True,
            privileged=True,
            tmpfs={"/run": "", "/var/run": ""},
            ports={
                "6443/tcp": API_PORT,
                **{f"{s['node_port']}/tcp": s["host_port"] for s in SERVERS.values()},
            },
            environment={
                "K3S_KUBECONFIG_OUTPUT": "/output/k3s.yaml",  # k3s's own copy, left untouched
                "K3S_KUBECONFIG_MODE": "644",
            },
            volumes={str(STATE): {"bind": "/output", "mode": "rw"}},
            labels={"pgbench": "k3s"},
        )
    elif node.status != "running":
        print(f"starting the stopped {NAME} ...")
        node.start()
    else:
        print(f"{NAME} is already running")

    # 1. the API server: k3s writes its kubeconfig once it is up (and kubectl inside the node reads
    #    that same file), so the host gets its own copy pointing at the mapped port
    internal = STATE / "k3s.yaml"
    kubeconfig = STATE / "kubeconfig.yaml"
    _wait("kubeconfig written", internal.exists, 120)
    kubeconfig.write_text(
        internal.read_text().replace(
            "https://127.0.0.1:6443", f"https://127.0.0.1:{API_PORT}"
        )
    )
    _wait(
        "node ready",
        lambda: (
            " Ready"
            in _exec(node, [*KUBECTL, "get", "node", "--no-headers"], check=False)
        ),
        120,
    )

    # 2. images from the local Docker cache, so k3s does not pull what is already here
    present = _exec(node, ["ctr", "-n", "k8s.io", "images", "ls", "-q"])
    for s in servers:
        image = SERVERS[s]["image"]
        if f"docker.io/library/{image}" in present or f"docker.io/{image}" in present:
            continue
        try:
            img = client.images.get(image)
        except docker.errors.ImageNotFound:
            print(f"  {image} is not in the local cache; k3s will pull it")
            continue
        tar = STATE / f"{s}.tar"
        t0 = time.perf_counter()
        with tar.open("wb") as f:
            for chunk in img.save(named=True):
                f.write(chunk)
        _exec(
            node,
            ["ctr", "-n", "k8s.io", "images", "import", f"/output/{tar.name}"],
        )
        tar.unlink()
        print(f"  imported {image} in {time.perf_counter() - t0:.0f}s")

    # 3. manifests into k3s's auto-deploy directory; pgrust.yaml relies on the ConfigMap in pg16.yaml
    docs = (HERE / "pg16.yaml").read_text().split("\n---\n")
    files = {"initdb.yaml": next(d for d in docs if "kind: ConfigMap" in d).encode()}
    for s in servers:
        files[SERVERS[s]["manifest"]] = (HERE / SERVERS[s]["manifest"]).read_bytes()
    _put_files(node, MANIFEST_DIR, files)

    # 4. ready means Postgres answers on the host port, not just that the pod exists
    dsns = {}
    for s in servers:
        _wait(
            f"{s} pod ready",
            lambda s=s: (
                "condition met"
                in _exec(
                    node,
                    [
                        *KUBECTL,
                        "wait",
                        "--for=condition=ready",
                        "pod",
                        "-l",
                        f"app={s}",
                        "--timeout=5s",
                    ],
                    check=False,
                )
            ),
            300,
        )
        dsn = f"postgresql://app:pwd@localhost:{SERVERS[s]['host_port']}/app"

        def answers(dsn=dsn) -> bool:
            try:
                with psycopg.connect(dsn, connect_timeout=2):
                    return True
            except psycopg.OperationalError:
                return False

        _wait(f"{s} answering on localhost:{SERVERS[s]['host_port']}", answers, 120)
        dsns[s] = dsn
    print("kubeconfig:", kubeconfig)
    return dsns


def down() -> None:
    client = docker.from_env()
    node = _node(client)
    if node is None:
        print(f"{NAME} does not exist")
    else:
        node.remove(force=True)
        print(f"removed {NAME}")
    for p in STATE.glob("*"):
        p.unlink()
    if STATE.exists():
        STATE.rmdir()


def status() -> None:
    client = docker.from_env()
    node = _node(client)
    if node is None:
        print(f"{NAME} does not exist; `uv run k8s/k3s.py up`")
        return
    print(f"{NAME}: {node.status}, ports {node.ports}")
    if node.status == "running":
        print(_exec(node, [*KUBECTL, "get", "pods,svc", "-o", "wide"], check=False))


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("action", choices=["up", "down", "status"])
    ap.add_argument("--server", default="both", choices=["pg16", "pgrust", "both"])
    args = ap.parse_args()
    if args.action == "up":
        servers = list(SERVERS) if args.server == "both" else [args.server]
        t0 = time.perf_counter()
        dsns = up(servers)
        print(
            f"ready in {time.perf_counter() - t0:.0f}s:",
            ", ".join(f"{s} on {d.split('@')[-1]}" for s, d in dsns.items()),
        )
    elif args.action == "down":
        down()
    else:
        status()


if __name__ == "__main__":
    sys.exit(main())
