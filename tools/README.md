# Outils d'agents de code IA — installation Windows

`install-agent-tools.ps1` installe et vérifie, sur un poste Windows, les CLI d'outillage
d'agents de code IA.

## Ce qui est installé

| Outil | Paquet | Rôle | Windows |
|---|---|---|---|
| `graphify` | `@sentropic/graphify` | Transforme un dossier de code, de docs ou de transcriptions en graphe de connaissances interrogeable par Claude Code, Codex, Gemini CLI, etc. | Oui |
| `omniroute` | `omniroute` | Routeur IA unifié : 160+ fournisseurs, bascule automatique, API compatible OpenAI, MCP/A2A | Oui |
| `observer` | `@superbased/observer` | Observabilité des agents : comptage des tokens, coûts et fichiers touchés, sur 33 adaptateurs (Claude Code, Cursor, Codex…) | Oui |
| `herdr` | crates.io / herdr.dev | Gestionnaire d'espaces de travail terminal pour agents IA (panneaux tuilés, détection d'état des agents) | **Non — Linux/macOS seulement** |

## Prérequis

- **Node.js** dans le `PATH`.
  - `graphify` exige Node ≥ 20.
  - `omniroute` exige Node **≥ 22.22.2 < 23**, ou **≥ 24 < 27**. Le script vérifie et saute
    l'installation plutôt que d'échouer si la version ne correspond pas.
- Aucun droit administrateur, sauf si `npm` a été configuré avec un préfixe dans `Program Files`.

## Utilisation

```powershell
# Tout installer (sauf herdr)
.\install-agent-tools.ps1

# Voir ce qui serait fait, sans rien installer
.\install-agent-tools.ps1 -WhatIfOnly

# Un seul outil
.\install-agent-tools.ps1 -Tools observer

# Inclure herdr via WSL2
.\install-agent-tools.ps1 -IncludeHerdr
```

Si l'exécution de scripts est bloquée :

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent-tools.ps1
```

Le script est idempotent : relancé, il met simplement les paquets à jour vers la dernière version.
Il retourne le code de sortie `1` si au moins une installation échoue.

## Le cas herdr

herdr n'a pas de version Windows. Son README officiel indique `requirements: linux or macos`,
et sa détection d'état des agents lit `/proc` (Linux) ou `proc_pidinfo` (macOS) — deux mécanismes
qui n'existent pas sous Windows.

Deux options :

1. **WSL2** — `.\install-agent-tools.ps1 -IncludeHerdr` exécute le script d'installation officiel
   (`https://herdr.dev/install.sh`) dans la distribution WSL par défaut. Il faut donc que WSL2
   soit déjà installé (`wsl --install`).
2. **Compilation depuis les sources**, dans WSL, si le script officiel échoue :
   ```bash
   cargo install herdr   # nécessite rustup
   ```

À noter : herdr gère des agents qui tournent **dans la même session terminal**. Lancé dans WSL, il
gérera des agents WSL, pas des processus Windows natifs.

## Désinstallation

```powershell
npm uninstall -g @sentropic/graphify omniroute @superbased/observer
wsl -- bash -lc 'rm -f ~/.local/bin/herdr && rm -rf ~/.config/herdr'
```

`omniroute` fournit aussi son propre script de désinstallation (`npm run uninstall` dans son
répertoire d'installation) qui nettoie sa base de données locale et sa configuration.

## Vérification manuelle

```powershell
graphify --version
omniroute --version
observer --version
wsl -- herdr --version
```

## Notes

- `omniroute` installe environ 1 200 paquets (il embarque une application Next.js et un
  empaquetage Electron). Prévoir quelques minutes et ~500 Mo.
- `observer` télécharge un binaire préconstruit selon la plateforme
  (`@superbased/observer-win32-x64` sous Windows).
- Après installation, il peut être nécessaire de rouvrir le terminal pour que le `PATH` soit
  rafraîchi.
