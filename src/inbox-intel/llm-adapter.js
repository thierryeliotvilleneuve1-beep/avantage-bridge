// Inbox Intel — Adaptateur LLM (moteur de classification cible).
// Le MVP tourne hors-ligne avec l'heuristique ; cet adaptateur définit le
// contrat et le prompt pour brancher un vrai modèle :
//   - InvokeLLM de Base44 (côté app Manoeuvre), ou
//   - l'API Anthropic depuis le bridge (ANTHROPIC_API_KEY).
// Dans les deux cas la sortie attendue est le JSON décrit ci-dessous.

const PROMPT_ANALYSE = `Tu analyses un courriel reçu par CRC (Construction Richard Champagne),
entrepreneur général au Québec, pour le rattacher à la timeline d'un projet.

Courriel :
- De : {{expediteur}}
- À : {{destinataires}}
- CC : {{cc}}
- Objet : {{objet}}
- Corps :
{{corps}}

Réponds UNIQUEMENT avec un objet JSON :
{
  "type_document": "dessin_atelier" | "facture" | "rfi" | "retard" | "reclamation" | "directive_chantier" | "general",
  "confiance": nombre entre 0 et 1,
  "resume_court": "résumé factuel en 1-2 phrases, en français",
  "code_projet_detecte": "code projet si mentionné (ex. P23020), sinon null",
  "action_suggeree": "action concrète que le chef de projet devrait considérer, déduite du CONTENU réel (pas un gabarit par type)",
  "justification": "pourquoi cette action, en citant le courriel",
  "priorite": "basse" | "normale" | "haute" | "urgente",
  "echeance_suggeree": "date ISO si une échéance est mentionnée, sinon null"
}`;

class LLMAdapter {
  constructor(opts = {}) {
    this.backend = opts.backend || null; // fonction async (prompt) => texte JSON
  }

  disponible() {
    return typeof this.backend === 'function';
  }

  construirePrompt(courriel) {
    return PROMPT_ANALYSE
      .replace('{{expediteur}}', `${courriel.expediteur_nom || ''} <${courriel.expediteur_email || ''}>`)
      .replace('{{destinataires}}', (courriel.destinataires || []).join(', '))
      .replace('{{cc}}', (courriel.cc || []).join(', '))
      .replace('{{objet}}', courriel.objet || '')
      .replace('{{corps}}', courriel.corps || '');
  }

  async analyser(courriel) {
    if (!this.disponible()) return null;
    try {
      const brut = await this.backend(this.construirePrompt(courriel));
      const json = JSON.parse(brut.replace(/^```json?\s*|\s*```$/g, ''));
      return { ...json, methode: 'llm' };
    } catch (e) {
      // Repli silencieux sur l'heuristique ; l'appelant journalise.
      return null;
    }
  }
}

module.exports = { LLMAdapter, PROMPT_ANALYSE };
