export function notFound(_req, res, _next) {
  res.status(404).json({ error: 'not found' });
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.publicMessage ?? err.message ?? 'server error' });
}
