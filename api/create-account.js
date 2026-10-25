// Fonction serveur Vercel — création directe d'un compte par un admin
// (sans passer par une demande). Toujours réservée à l'admin de son serveur.
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('role, server_id, status')
      .eq('id', userData.user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
      return res.status(403).json({ error: "Seul l'administrateur de ce serveur peut créer des comptes." });
    }

    const { username, email, password, displayName, color, role, permissions } = req.body;
    if (!username || !email || !password || !displayName) {
      return res.status(400).json({ error: 'Champs manquants.' });
    }

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) return res.status(400).json({ error: createErr.message });

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      server_id: callerProfile.server_id,
      username, email, display_name: displayName,
      color: color || '#5B9EF5',
      role: role || 'member',
      permissions: permissions || {},
      status: 'approved',
    });
    if (profileErr) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return res.status(400).json({ error: profileErr.message });
    }

    return res.status(200).json({ ok: true, id: created.user.id });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
