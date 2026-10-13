// Placeholder entry; replaced by the OAuthProvider wiring in U3/U4.
export default {
  async fetch(): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
};
