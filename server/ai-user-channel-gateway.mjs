// Legacy listing freezes model names in its plan. Route only through this user's
// channels with the same model pair so retries cannot silently change the plan.
export function createUserChannelGateway(channels) {
  return Object.fromEntries(['createTextResponse','generateImage','inspectImage'].map(method=>[method,async input=>{
    const result=await channels.run({accountId:input.profile.accountId,taskId:input.correlationId||input.requestKey,
      requestKey:input.requestKey,textModel:input.profile.textModel,imageModel:input.profile.imageModel},async({gateway,profile})=>{
      const payload=await gateway[method]({...input,profile});
      return {payload,gatewayRequestId:payload.requestId};
    });
    return result.payload;
  }]));
}
