// Gate: req.user.role must match; role is read from the DB in requireAuth
export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
