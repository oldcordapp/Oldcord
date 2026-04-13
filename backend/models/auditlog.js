const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  actionType: {
    type: String,
    required: true,
    enum: ['BAN', 'KICK', 'MUTE', 'UNMUTE', 'WARN', 'CHANNEL_CREATE', 'CHANNEL_DELETE', 'CHANNEL_UPDATE', 'ROLE_CREATE', 'ROLE_DELETE', 'ROLE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_EDIT']
  },
  actorId: {
    type: String,
    required: true,
    index: true
  },
  actorName: {
    type: String,
    required: true
  },
  targetId: {
    type: String,
    index: true
  },
  targetName: {
    type: String
  },
  resourceType: {
    type: String,
    enum: ['USER', 'CHANNEL', 'ROLE', 'MESSAGE', 'SERVER']
  },
  resourceId: {
    type: String
  },
  resourceName: {
    type: String
  },
  reason: {
    type: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

auditLogSchema.index({ createdAt: -1 });

auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
