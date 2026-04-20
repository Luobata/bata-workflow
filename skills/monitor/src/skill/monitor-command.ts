export interface OpenMonitorSessionInput {
  rootSessionId: string
  requesterActorId: string
  isRootActor: boolean
  existingMonitorSessionId: string | null
}

export interface OpenMonitorSessionResult {
  kind: 'create' | 'attach'
  monitorSessionId: string
  rootSessionId: string
  requesterActorId: string
  isRootActor: boolean
  message: string
}

export const deriveMonitorSessionId = (rootSessionId: string): string => `monitor:${rootSessionId}`

export const openMonitorSession = (input: OpenMonitorSessionInput): OpenMonitorSessionResult => {
  const monitorSessionId = input.existingMonitorSessionId ?? deriveMonitorSessionId(input.rootSessionId)

  if (input.existingMonitorSessionId) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId: input.rootSessionId,
      requesterActorId: input.requesterActorId,
      isRootActor: input.isRootActor,
      message: `Attached actor ${input.requesterActorId} to existing monitor ${monitorSessionId}`,
    }
  }

  if (!input.isRootActor) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId: input.rootSessionId,
      requesterActorId: input.requesterActorId,
      isRootActor: input.isRootActor,
      message: `Child actor ${input.requesterActorId} cannot create a nested monitor; attach to ${monitorSessionId}`,
    }
  }

  return {
    kind: 'create',
    monitorSessionId,
    rootSessionId: input.rootSessionId,
    requesterActorId: input.requesterActorId,
    isRootActor: input.isRootActor,
    message: `Created monitor ${monitorSessionId} for root actor ${input.requesterActorId}`,
  }
}
