declare module "tcp-port-used" {
  const tcpPortUsed: {
    check(port: number, host?: string): Promise<boolean>;
  };

  export default tcpPortUsed;
}
