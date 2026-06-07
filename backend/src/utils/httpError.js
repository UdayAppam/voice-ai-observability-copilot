function httpError(code, message, status) {
  const err = new Error(message)
  err.code = code
  err.status = status
  return err
}

module.exports = httpError
