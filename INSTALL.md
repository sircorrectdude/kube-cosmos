# kube-cosmos im Cluster installieren

**Stufe 1 (aktuell):** reine Visualisierung im Cluster – `MODE=readonly`, Befehle/Sprachsteuerung aus,
nur Leserechte, Zugriff per Port-Forward. Stufe 2 (Anmeldung, Rollen, Befehle) folgt später.

## Was installiert wird

| Objekt | Zweck |
|---|---|
| Namespace `kube-cosmos` | alles von kube-cosmos |
| ServiceAccount + ClusterRole `kube-cosmos-reader` | **nur lesen**: namespaces, nodes, pods, services, events, deployments, `pods/log` (für echten Traffic). Keine Secrets, kein Schreiben. |
| Deployment `kube-cosmos` | 1 Pod, Image mit Backend + Frontend, Port 8080, läuft als non-root mit read-only Dateisystem |
| Service `kube-cosmos` (ClusterIP) | kein Zugang von außen – nur per `kubectl port-forward` |

Voraussetzungen: `kubectl` mit Admin-Rechten (für die ClusterRole), Docker zum Bauen, eine Registry mit TLS,
aus der das Cluster Images ziehen kann (z.B. GHCR, Docker Hub, Harbor, ECR/ACR/GCR).

---

## Docker Desktop (lokal): außerhalb des Clusters betreiben

Docker Desktop im **kind-Modus** sieht lokal gebaute Images nicht, und eine lokale Registry ohne TLS funktioniert
mit dem containerd der Nodes nicht (getestet: „short read: expected … bytes but got 0“; die Nodes sind versteckt,
containerd lässt sich nicht konfigurieren). Lokal läuft kube-cosmos daher als Prozess auf dem Rechner und greift
per kubeconfig auf das Cluster zu – siehe [README.md](README.md):

```bash
cd backend && npm install && npm start        # ws://127.0.0.1:7070/ws, Context docker-desktop
cd frontend && npm install && npm run dev     # http://127.0.0.1:5173
```

## Beliebiges Cluster (mit eigener Registry)

```bash
docker build -t <registry>/kube-cosmos:0.1.0 .
docker push <registry>/kube-cosmos:0.1.0
kubectl apply -f deploy/readonly.yaml
kubectl -n kube-cosmos set image deploy/kube-cosmos kube-cosmos=<registry>/kube-cosmos:0.1.0
kubectl -n kube-cosmos port-forward svc/kube-cosmos 7070:80
```
Private Registry: zusätzlich ein `imagePullSecret` im Namespace `kube-cosmos` anlegen und im Deployment eintragen.

---

## Konfiguration (Env im Deployment)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MODE` | `readonly` | im Cluster nur `readonly` (Stufe 1). `local` verweigert den Start mit `K8S_AUTH=incluster`. |
| `NAMESPACES` | leer = alle | nur diese Namespaces anzeigen, z.B. `team-a,team-b` |
| `TRAFFIC_SOURCE` | `logs` | `logs` = echte Access-Logs, `mock` = simuliert, `none` = aus |
| `LOG_SELECTOR` | `kube-cosmos.io/access-log` | Pods mit diesem Label liefern Access-Logs (CLF: nginx, traefik) |
| `MAX_FLOWS_PER_SEC` | `600` | Obergrenze Request/Response-Paare pro Sekunde (Sampling) |

| `LLM_PROVIDER` | `ollama` | `ollama` oder `openai` (jede OpenAI-kompatible API) – erst ab Stufe 2 relevant (Befehle) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Ollama lokal, `qwen2.5-coder:7b` | Modellwechsel nur per Konfiguration; API-Key als Secret einbinden |
| `PROMETHEUS_URL` | leer = aus | **optionale Integration**: CPU/RAM je Pod + Node-Last, z.B. `http://monitoring-kube-prometheus-prometheus.monitoring.svc:9090` |
| `PROMETHEUS_TOKEN` | leer | optional Bearer-Token, falls Prometheus hinter einem Auth-Proxy liegt |
| `METRICS_INTERVAL_SEC` | `10` | Abfrageintervall |

Ändern: `kubectl -n kube-cosmos set env deploy/kube-cosmos NAMESPACES=team-a,team-b`

Prometheus-Integration: benötigt cAdvisor-Metriken (kubelet), für Limits kube-state-metrics, für Node-Last node-exporter –
im kube-prometheus-stack alles enthalten. Ist Prometheus nicht erreichbar, läuft kube-cosmos ohne Metriken weiter.
Falls NetworkPolicies im Namespace `monitoring` aktiv sind: Zugriff von `kube-cosmos` auf Port 9090 erlauben.

## Echten Traffic sichtbar machen

kube-cosmos liest die Access-Logs von Pods, die das Label `kube-cosmos.io/access-log` tragen
(Wert beliebig; `traefik`/`ingress` kennzeichnet Ingress-Pods). Beispiel für eigene nginx-Deployments:

```yaml
spec:
  template:
    metadata:
      labels:
        kube-cosmos.io/access-log: nginx
```

Traefik (Helm) dauerhaft: `logs.access.enabled=true` und `deployment.podLabels."kube-cosmos\.io/access-log"=traefik` in den Helm-Values.

Externe Quellen erscheinen als Satelliten, getrennt nach Eintrittspunkt (Traefik-Router) und Client-Typ
(Browser, Skript, Bot, Monitoring – aus dem User-Agent). Traefik schreibt den User-Agent standardmäßig
**nicht** ins Access-Log; dann ist jeder Ingress-Satellit „unbekannt“. Aktivieren:

- Traefik-Argument: `--accesslog.fields.headers.names.User-Agent=keep`
- oder Helm-Values: `logs.access.fields.headers.names.User-Agent=keep`

Beispiel ohne Helm (Patch geht bei einem Helm-Upgrade verloren):

```bash
kubectl -n traefik patch deployment traefik --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--accesslog.fields.headers.names.User-Agent=keep"}]'
```

nginx (Format `combined`) loggt den User-Agent bereits.
Ohne Cilium/Service-Mesh nötig; sichtbar sind HTTP-Requests von loggenden Servern.

## Deinstallieren

```bash
kubectl delete -f deploy/readonly.yaml
```

## Sicherheit (Stufe 1)

- Nur Leserechte, keine Secrets – Pod-Specs/Env werden nie übertragen, nur Name, Status, Labels, Probes.
- Kein Ingress: Wer `port-forward` darf, sieht die Topologie. Zugriff über RBAC auf `pods/portforward` im Namespace `kube-cosmos` steuern.
- Befehle/Sprachsteuerung sind im Modus `readonly` serverseitig deaktiviert.

## Ausblick Stufe 2 (Team-Betrieb)

oauth2-proxy-Sidecar (OIDC), Rollen viewer/operator/approver aus Gruppen, Befehle per Impersonation (`--as=<user>`, es gelten die
eigenen Kubernetes-Rechte des Nutzers), Freigabe destruktiver Befehle, Audit-Log (JSON nach stdout), Metrics, Ingress mit TLS,
LLM (Ollama) als eigener Dienst im Cluster.
