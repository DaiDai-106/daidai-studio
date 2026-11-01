import type { Arguments, Method, Results } from "../contracts/application.ts";

export type Handlers<K extends Method = Method> = {
  [P in K]: (args: Arguments<P>) => Promise<Results[P]>;
};
