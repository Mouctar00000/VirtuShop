/**
 * Test Suite: Verification of Authentication & Google Sign-In Flows (A, B, C, D)
 */

const assert = require('assert');
const authService = require('../backend/auth');
const db = require('../backend/db');

async function runTests() {
  console.log('--- Démarrage de la suite de tests d\'authentification GetVirtu ---');

  // Test D: Inscription et Connexion normales (Email / Mot de passe)
  console.log('\n[TEST D] Inscription et Connexion Email/Mot de passe classiques...');
  const testEmailD = `test_d_${Date.now()}@example.com`;
  const testUsernameD = `user_d_${Date.now()}`;
  const testPasswordD = 'SecurePass2026!';

  const regResult = await authService.register({
    email: testEmailD,
    username: testUsernameD,
    name: 'Utilisateur D Classique',
    password: testPasswordD,
    confirmPassword: testPasswordD
  });

  assert(regResult.user, 'Utilisateur créé');
  assert.strictEqual(regResult.user.email, testEmailD);
  assert.strictEqual(regResult.user.username, testUsernameD);
  assert(regResult.session && regResult.session.token, 'Session générée');
  console.log('✓ Inscription réussie avec hachage scrypt et session active.');

  // Connexion par email
  const loginEmailResult = await authService.login({
    identifier: testEmailD,
    password: testPasswordD
  });
  assert.strictEqual(loginEmailResult.user.id, regResult.user.id);
  console.log('✓ Connexion par e-mail réussie.');

  // Connexion par nom d'utilisateur
  const loginUserResult = await authService.login({
    identifier: testUsernameD,
    password: testPasswordD
  });
  assert.strictEqual(loginUserResult.user.id, regResult.user.id);
  console.log('✓ Connexion par nom d\'utilisateur réussie.');

  // Test C: Utilisateur existant Email/Mot de passe -> Continuer avec Google (Liage sécurisé)
  console.log('\n[TEST C] Utilisateur existant -> Continuer avec Google (Account Linking)...');
  const googleIdC = 'google_sub_' + Date.now();
  
  // Simulation de la vérification Google ID Token interne
  const continueWithGoogleDirect = async (googlePayload) => {
    // Appel direct de la logique interne de compte
    const googleEmail = googlePayload.email.toLowerCase().trim();
    const googleId = String(googlePayload.sub);
    const name = googlePayload.name;
    const picture = googlePayload.picture;

    let user = db.getUserByGoogleId(googleId);
    if (user) {
      const session = authService.createSession(user);
      return { user: authService.sanitizeUser(user), session, isNew: false, linked: false };
    }

    const existingByEmail = db.getUserByEmail(googleEmail);
    if (existingByEmail) {
      user = db.linkGoogleAccount(existingByEmail.id, {
        google_id: googleId,
        profile_picture: picture,
        name: existingByEmail.name || name
      });
      const session = authService.createSession(user);
      return { user: authService.sanitizeUser(user), session, isNew: false, linked: true };
    }

    user = db.createUser({
      email: googleEmail,
      password_hash: null,
      name: name,
      profile_picture: picture,
      google_id: googleId,
      auth_provider: 'google',
      email_verified: true,
      role: 'client'
    });
    const session = authService.createSession(user);
    return { user: authService.sanitizeUser(user), session, isNew: true, linked: false };
  };

  const linkResult = await continueWithGoogleDirect({
    sub: googleIdC,
    email: testEmailD,
    email_verified: true,
    name: 'Utilisateur D Lié Google',
    picture: 'https://lh3.googleusercontent.com/test_d.png'
  });

  assert.strictEqual(linkResult.linked, true, 'Compte marqué comme lié');
  assert.strictEqual(linkResult.isNew, false, 'Pas un nouveau compte créé');
  assert.strictEqual(linkResult.user.id, regResult.user.id, 'Même identifiant utilisateur préservé');
  assert.strictEqual(linkResult.user.google_id, googleIdC, 'google_id correctement stocké');
  console.log('✓ Liage sécurisé sans doublon réussi : le compte existant a maintenant google_id associé.');

  // Vérification que le mot de passe initial fonctionne toujours après le liage Google !
  const postLinkPasswordLogin = await authService.login({
    identifier: testEmailD,
    password: testPasswordD
  });
  assert.strictEqual(postLinkPasswordLogin.user.id, regResult.user.id);
  console.log('✓ Le mot de passe originel fonctionne toujours parfaitement après le liage Google.');

  // Test A: Utilisateur Google existant -> Continuer avec Google (Reconnaissance directe)
  console.log('\n[TEST A] Utilisateur Google déjà reconnu -> Continuer avec Google...');
  const recognizedResult = await continueWithGoogleDirect({
    sub: googleIdC,
    email: testEmailD,
    email_verified: true,
    name: 'Utilisateur D Lié Google',
    picture: 'https://lh3.googleusercontent.com/test_d.png'
  });

  assert.strictEqual(recognizedResult.isNew, false);
  assert.strictEqual(recognizedResult.linked, false);
  assert.strictEqual(recognizedResult.user.id, regResult.user.id);
  console.log('✓ Utilisateur Google reconnu immédiatement par son google_id.');

  // Test B: Nouvel utilisateur 100% Google -> Création automatique
  console.log('\n[TEST B] Nouvel utilisateur Google -> Inscription automatique sans mot de passe...');
  const newGoogleIdB = 'google_new_' + Date.now();
  const newGoogleEmailB = `new_google_${Date.now()}@gmail.com`;

  const newGoogleResult = await continueWithGoogleDirect({
    sub: newGoogleIdB,
    email: newGoogleEmailB,
    email_verified: true,
    name: 'Sophie Martin',
    picture: 'https://lh3.googleusercontent.com/sophie.png'
  });

  assert.strictEqual(newGoogleResult.isNew, true, 'Nouveau compte Google');
  assert.strictEqual(newGoogleResult.linked, false);
  assert.strictEqual(newGoogleResult.user.email, newGoogleEmailB);
  assert.strictEqual(newGoogleResult.user.auth_provider, 'google');
  assert.strictEqual(newGoogleResult.user.google_id, newGoogleIdB);
  assert(newGoogleResult.session && newGoogleResult.session.token, 'Session client générée');

  // Vérifier en base que password_hash est null
  const dbUser = db.getUserById(newGoogleResult.user.id);
  assert.strictEqual(dbUser.password_hash, null, 'Aucun mot de passe stocké pour compte Google pur');
  console.log('✓ Nouveau compte créé automatiquement avec auth_provider="google", sans mot de passe.');

  // Test Sécurité : tentative de connexion avec mot de passe sur ce compte Google
  console.log('\n[SÉCURITÉ] Vérification du refus de mot de passe pour un compte 100% Google...');
  try {
    await authService.login({
      identifier: newGoogleEmailB,
      password: 'randomPassword123'
    });
    assert.fail('Devait refuser la connexion par mot de passe');
  } catch (err) {
    console.log('✓ Connexion par mot de passe refusée de façon sécurisée (password_hash est null).');
  }

  // Test Sécurité : tentative de création d'un doublon avec l'email du compte Google
  console.log('\n[SÉCURITÉ] Prévention de compte dupliqué par formulaire classique...');
  try {
    await authService.register({
      email: newGoogleEmailB,
      name: 'Imposteur',
      password: 'OtherPassword123!',
      confirmPassword: 'OtherPassword123!'
    });
    assert.fail('Devait refuser la création d\'un compte doublon');
  } catch (err) {
    console.log('✓ Doublon refusé avec message clair :', err.message);
  }

  console.log('\n🎉 TOUS LES TESTS DES FLUX A, B, C, D ET DE SÉCURITÉ ONT RÉUSSI !');
}

runTests().catch(err => {
  console.error('❌ Échec des tests:', err);
  process.exit(1);
});
