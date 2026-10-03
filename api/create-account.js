// Fonction serveur Vercel — s'exécute UNIQUEMENT côté serveur.
// La clé SUPABASE_SERVICE_ROLE_KEY n'est jamais envoyée au navigateur.
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { username, email, password, displayName, color, role, permissions } = req.body;
    if (!username || !email || !password || !displayName) {
      return res.status(400).json({ error: 'Champs manquants.' });
    }

    // Est-ce le tout premier compte ? Si oui, il devient admin sans vérification
    // (c'est la seule exception — bootstrap initial du carnet).
    const { count } = await supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true });
    const isBootstrap = (count || 0) === 0;
    let finalRole = role || 'member';

    if (isBootstrap) {
      finalRole = 'admin';
    } else {
      // Sinon, seul un admin déjà connecté peut créer un compte
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Non authentifié' });

      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
      if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });

      const { data: callerProfile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .single();

      if (!callerProfile || callerProfile.role !== 'admin') {
        return res.status(403).json({ error: "Seul l'administrateur peut créer des comptes." });
      }
    }

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) return res.status(400).json({ error: createErr.message });

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      username, email, display_name: displayName,
      color: color || '#5B9EF5',
      role: finalRole,
      permissions: permissions || {},
    });
    if (profileErr) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return res.status(400).json({ error: profileErr.message });
    }

    return res.status(200).json({ ok: true, id: created.user.id, role: finalRole });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
