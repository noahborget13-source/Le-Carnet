// Fonction serveur Vercel — gestion des comptes.
//  • Actions de l'admin : delete, update, transfer-admin (même serveur uniquement).
//  • Actions de chacun sur son propre compte : update-self, delete-self.
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ALL_PERMS = { createTasks: true, editAnyTask: true, editOwnTask: true, deleteAnyTask: true, deleteOwnTask: true, sendMessages: true };
const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const LEAD_CHOICES = [15, 30, 60, 120, 240, 720, 1440]; // délais de rappel proposés (minutes)

async function requireUser(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Non authentifié' }); return null; }
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData?.user) { res.status(401).json({ error: 'Session invalide' }); return null; }
  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('id, role, server_id, status, username').eq('id', userData.user.id).single();
  if (!profile || profile.status !== 'approved') { res.status(403).json({ error: 'Accès refusé.' }); return null; }
  return profile;
}

async function updateSelf(me, body, res) {
  const patch = body.patch || {};
  const update = {};
  if (patch.display_name !== undefined) {
    const v = String(patch.display_name).trim();
    if (!v || v.length > 60) return res.status(400).json({ error: 'Nom affiché : 1 à 60 caractères.' });
    update.display_name = v;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) return res.status(400).json({ error: 'Couleur invalide.' });
    update.color = patch.color;
  }
  if (patch.username !== undefined) {
    const v = String(patch.username).trim();
    if (!USERNAME_RE.test(v)) return res.status(400).json({ error: 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -).' });
    if (v.toLowerCase() !== (me.username || '').toLowerCase()) {
      const { data: taken } = await supabaseAdmin.from('profiles').select('id').ilike('username', v).neq('id', me.id).limit(1);
      if (taken && taken.length) return res.status(400).json({ error: 'Cet identifiant est déjà pris, choisis-en un autre.' });
    }
    update.username = v;
  }
  // Préférences d'emails
  for (const key of ['notify_assigned', 'notify_soon', 'notify_overdue', 'notify_digest']) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') return res.status(400).json({ error: 'Préférence invalide.' });
      update[key] = patch[key];
    }
  }
  if (patch.remind_lead_minutes !== undefined) {
    const v = Number(patch.remind_lead_minutes);
    if (!LEAD_CHOICES.includes(v)) return res.status(400).json({ error: 'Délai de rappel invalide.' });
    update.remind_lead_minutes = v;
  }
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Rien à modifier.' });
  const { error } = await supabaseAdmin.from('profiles').update(update).eq('id', me.id);
  if (error) {
    const msg = /duplicate|unique/i.test(error.message) ? 'Cet identifiant est déjà pris, choisis-en un autre.' : error.message;
    return res.status(400).json({ error: msg });
  }
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const body = req.body || {};
  const { action, id, patch, newPassword } = body;

  try {
    const me = await requireUser(req, res);
    if (!me) return;

    // ---- Actions sur son propre compte ----
    if (action === 'update-self') return await updateSelf(me, body, res);
    if (action === 'delete-self') {
      if (me.role === 'admin') {
        return res.status(400).json({ error: "Tu es l'administrateur de ce serveur : transfère d'abord l'administration à quelqu'un d'autre." });
      }
      await supabaseAdmin.from('profiles').delete().eq('id', me.id);
      await supabaseAdmin.auth.admin.deleteUser(me.id);
      return res.status(200).json({ ok: true });
    }

    // ---- Actions réservées à l'admin ----
    if (me.role !== 'admin') return res.status(403).json({ error: "Seul l'administrateur peut faire ça." });
    const { data: target } = await supabaseAdmin.from('profiles').select('role, server_id, status').eq('id', id).single();
    if (!target || target.server_id !== me.server_id) {
      return res.status(403).json({ error: 'Ce compte ne fait pas partie de ton serveur.' });
    }

    if (action === 'delete') {
      if (target.role === 'admin') return res.status(400).json({ error: "Impossible de supprimer l'administrateur." });
      await supabaseAdmin.from('profiles').delete().eq('id', id);
      await supabaseAdmin.auth.admin.deleteUser(id);
      return res.status(200).json({ ok: true });
    }

    if (action === 'update') {
      if (newPassword) {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password: newPassword });
        if (error) return res.status(400).json({ error: error.message });
      }
      if (patch) {
        const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', id);
        if (error) return res.status(400).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'transfer-admin') {
      if (id === me.id) return res.status(400).json({ error: 'Tu es déjà administrateur.' });
      if (target.status !== 'approved') return res.status(400).json({ error: "Cette personne n'a pas encore été approuvée." });
      const up = await supabaseAdmin.from('profiles').update({ role: 'admin', permissions: ALL_PERMS }).eq('id', id);
      if (up.error) return res.status(400).json({ error: up.error.message });
      const down = await supabaseAdmin.from('profiles').update({ role: 'moderator', permissions: ALL_PERMS }).eq('id', me.id);
      if (down.error) {
        await supabaseAdmin.from('profiles').update({ role: target.role }).eq('id', id); // on annule
        return res.status(400).json({ error: down.error.message });
      }
      await supabaseAdmin.from('servers').update({ owner_id: id }).eq('id', me.server_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
