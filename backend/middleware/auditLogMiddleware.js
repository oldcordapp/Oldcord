const auditLogService = require('../services/auditLogService');

const createAuditLogMiddleware = (actionType, options = {}) => {
  const {
    getActor = (req) => req.user?.id || req.user?._id,
    getTarget = (req) => req.params.userId || req.params.memberId,
    getResource = (req) => req.params.resourceId || req.params.id,
    getReason = (req) => req.body.reason || req.query.reason,
    getDetails = (req) => req.body,
  } = options;

  return async (req, res, next) => {
    const originalSend = res.send;

    res.send = function (body) {
      res.send = originalSend;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        const auditData = {
          actionType,
          actorId: getActor(req),
          targetId: getTarget(req),
          resourceId: getResource(req),
          reason: getReason(req),
          details: getDetails(req),
          ipAddress: req.ip || req.connection?.remoteAddress,
          userAgent: req.get('User-Agent'),
        };

        auditLogService.log(auditData).catch((err) => {
          console.error('Failed to create audit log:', err);
        });
      }

      return res.send(body);
    };

    next();
  };
};

const withAuditLog = (actionType, options) => createAuditLogMiddleware(actionType, options);

module.exports = {
  createAuditLogMiddleware,
  withAuditLog,
};
