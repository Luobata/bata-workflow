export function deriveMonitorSessionId(rootSessionId) {
  return `monitor:${rootSessionId}`
}

export function openMonitorSession({ rootSessionId, requesterActorId, isRootActor, existingMonitorSessionId }) {
  const monitorSessionId = existingMonitorSessionId ?? deriveMonitorSessionId(rootSessionId)

  if (existingMonitorSessionId) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId,
      requesterActorId,
      isRootActor,
      message: `Attached actor ${requesterActorId} to existing monitor ${monitorSessionId}`,
    }
  }

  if (!isRootActor) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId,
      requesterActorId,
      isRootActor,
      message: `Child actor ${requesterActorId} cannot create a nested monitor; attach to ${monitorSessionId}`,
    }
  }

  return {
    kind: 'create',
    monitorSessionId,
    rootSessionId,
    requesterActorId,
    isRootActor,
    message: `Created monitor ${monitorSessionId} for root actor ${requesterActorId}`,
  }
}
