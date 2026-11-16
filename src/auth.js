// Microsoft Entra ID bearer-token validation (access token issued to the browser by MSAL).
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

export function createAuth(config) {
  const devAuth = config.devAuth && !config.isProduction;
  const jwks = config.tenantId
    ? jwksClient({
        jwksUri: `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
        cache: true,
        rateLimit: true,
      })
    : null;

  const getKey = (header, cb) => jwks.getSigningKey(header.kid, (err, key) => cb(err, key && key.getPublicKey()));

  const verify = (token) =>
    new Promise((resolve, reject) =>
      jwt.verify(
        token,
        getKey,
        {
          algorithms: ["RS256"],
          audience: [`api://${config.clientId}`, config.clientId],
          issuer: [
            `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
            `https://sts.windows.net/${config.tenantId}/`,
          ],
        },
        (err, claims) => (err ? reject(err) : resolve(claims)),
      ),
    );

  // Admin = the Entra app role (default "Admin") on the signed-in user's token.
  const isAdmin = (claims) => (claims.roles || []).includes(config.adminRole);

  /** Express middleware: sets req.user = { name, email, isAdmin } or responds 401. */
  async function authenticate(req, res, next) {
    try {
      if (devAuth) {
        const email = config.devUserEmail;
        req.user = { id: email.toLowerCase(), name: config.devUserName, email, isAdmin: isAdmin({ roles: [config.adminRole] }) };
        return next();
      }
      if (!jwks || !config.clientId) return res.status(503).json({ error: "SSO is not configured on the server" });
      const m = /^Bearer (.+)$/i.exec(req.get("authorization") || "");
      if (!m) return res.status(401).json({ error: "Sign-in required" });
      const claims = await verify(m[1]);
      const email = claims.preferred_username || claims.upn || claims.email || claims.unique_name;
      if (!email) return res.status(401).json({ error: "Token has no user email" });
      const admin = isAdmin(claims);
      // Must hold the user role (Default) or the Admin role to use the app at all.
      if (!admin && !(claims.roles || []).includes(config.userRole)) {
        return res.status(403).json({ error: "You have not been granted access to this application. Contact IT." });
      }
      req.user = { id: String(claims.oid || email).toLowerCase(), name: claims.name || email, email, isAdmin: admin };
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid or expired sign-in" });
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Admin access required" });
    next();
  }

  return { authenticate, requireAdmin, devAuth };
}
