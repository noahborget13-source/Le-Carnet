// Fonction serveur Vercel — suppression et modification de comptes (admin uniquement).
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Non authentifié' }); return null; }
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData?.user) { res.status(401).json({ error: 'Session invalide' }); return null; }
  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || profile.role !== 'admin') { res.status(403).json({ error: "Seul l'administrateur peut faire ça." }); return null; }
  return userData.user;
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { action, id, patch, newPassword } = req.body;

  try {
    if (action === 'delete') {
      const { data: target } = await supabaseAdmin.from('profiles').select('role').eq('id', id).single();
      if (target?.role === 'admin') return res.status(400).json({ error: "Impossible de supprimer l'administrateur." });
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

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
