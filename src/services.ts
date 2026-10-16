import { invoke } from "@tauri-apps/api/core";
import mongodbLogo from "./assets/mongodb.svg";
import postgresLogo from "./assets/postgresql.svg";
import rabbitmqLogo from "./assets/rabbitmq.svg";
import redisLogo from "./assets/redis.svg";

export type ServiceType = "postgres" | "redis" | "rabbitmq" | "mongodb";

// Mirrors `Service` in src-tauri/src/lib.rs (serde camelCase).
export interface Service {
  name: string;
  serviceType: ServiceType;
  port: string;
  status: string; // raw docker status, e.g. "Up 3 minutes", "Exited (0) 2 hours ago"
  running: boolean;
  image: string;
  label: string; // custom name, "" if none
}

export interface Stats {
  cpu: string; // e.g. "0.80%"
  mem: string; // e.g. "12.3MiB"
}

export type Action = "start" | "stop" | "restart" | "rm";

export const TEMPLATES: Record<
  ServiceType,
  { title: string; port: number; image: string; logo: string; url: (port: string) => string }
> = {
  redis: { title: "Redis", port: 6379, image: "redis:latest", logo: redisLogo, url: (p) => `redis://localhost:${p}` },
  postgres: {
    title: "Postgres",
    port: 5432,
    image: "postgres:latest",
    logo: postgresLogo,
    url: (p) => `postgresql://postgres:postgres@localhost:${p}/postgres`,
  },
  mongodb: { title: "MongoDB", port: 27017, image: "mongo:latest", logo: mongodbLogo, url: (p) => `mongodb://localhost:${p}` },
  rabbitmq: {
    title: "RabbitMQ",
    port: 5672,
    image: "rabbitmq:management",
    logo: rabbitmqLogo,
    url: (p) => `amqp://guest:guest@localhost:${p}`,
  },
};

export const listServices = () => invoke<Service[]>("list_services");
export const serviceStats = () => invoke<Record<string, Stats>>("service_stats");
export const containerAction = (name: string, action: Action) =>
  invoke<string>("container_action", { name, action });
export const containerLogs = (name: string) => invoke<string>("container_logs", { name });
export const startService = (serviceType: ServiceType, port: string, image: string, name = "", persist = true) =>
  invoke<string>("start_service", { serviceType, port, image, name, persist });
export const portInUse = (port: number) => invoke<boolean>("port_in_use", { port });
