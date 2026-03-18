# BridgeKitty Backend Kubernetes Deployment

This directory contains Kubernetes manifests for deploying the BridgeKitty backend service.

## Prerequisites

- Kubernetes cluster (1.24+)
- NGINX Ingress Controller
- (Optional) cert-manager for automatic TLS

## Quick Start

1. **Create the namespace and secrets:**
   ```bash
   kubectl create namespace bridgekitty
   
   kubectl create secret generic bridgekitty-secrets \
     --from-literal=FEE_RECIPIENT_ADDRESS=0xYOUR_WALLET \
     --from-literal=LIFI_API_KEY=your-key \
     --from-literal=SQUID_INTEGRATOR_ID=your-id \
     -n bridgekitty
   ```

2. **Create GHCR pull secret (for private images):**
   ```bash
   kubectl create secret docker-registry ghcr-pull-secret \
     --docker-server=ghcr.io \
     --docker-username=<github-username> \
     --docker-password=<github-pat> \
     -n bridgekitty
   ```

3. **Apply with Kustomize:**
   ```bash
   kubectl apply -k k8s/
   ```

4. **Verify deployment:**
   ```bash
   kubectl get pods -n bridgekitty
   kubectl get ingress -n bridgekitty
   ```

## Files

| File | Description |
|------|-------------|
| `base/deployment.yaml` | Deployment with 2 replicas, health probes, resource limits |
| `base/service.yaml` | ClusterIP service on port 80 → container 3000 |
| `base/configmap.yaml` | Non-sensitive config (rate limits, TTLs, log level) |
| `base/secret.yaml` | Template for sensitive values (API keys, fee wallet) |
| `base/ingress.yaml` | NGINX Ingress with TLS, CORS, rate limiting |
| `base/hpa.yaml` | HorizontalPodAutoscaler (2→10 pods, CPU/memory based) |
| `kustomization.yaml` | Kustomize config for easy deployment |

## Configuration

### Environment Variables (ConfigMap)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | production | Environment mode |
| `LOG_LEVEL` | info | Logging level |
| `QUOTE_RATE_LIMIT` | 30 | Requests/min per IP for /quote |
| `EXECUTE_RATE_LIMIT` | 10 | Requests/min per IP for /execute |
| `QUOTE_TTL_SECONDS` | 300 | Quote cache TTL (5 min) |

### Secrets (Required)

| Variable | Description |
|----------|-------------|
| `FEE_RECIPIENT_ADDRESS` | Wallet address for affiliate fees |
| `LIFI_API_KEY` | LI.FI API key |
| `SQUID_INTEGRATOR_ID` | Squid Router integrator ID |

## TLS / Cert-Manager

To enable automatic TLS with Let's Encrypt, add these annotations to the Ingress:

```yaml
cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

Or manually create the TLS secret:

```bash
kubectl create secret tls bridgekitty-tls \
  --cert=path/to/tls.crt \
  --key=path/to/tls.key \
  -n bridgekitty
```

## Scaling

The HPA is configured to:
- **Min replicas:** 2
- **Max replicas:** 10
- **Scale on:** 70% CPU, 80% memory
- **Scale up:** +2 pods every 60s (after 30s cooldown)
- **Scale down:** -1 pod every 2m (after 5m cooldown)

## DNS

Point `bridgekitty.persistence.one` to your ingress controller's external IP:

```bash
kubectl get ingress -n bridgekitty
# Add the EXTERNAL-IP to your DNS records
```
