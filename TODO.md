remaining work:

- bignum consistency (aka make aura-js use system bigint)
  - bigint is the system type
  - BigInt in the constructor for that system type
  - aurajs uses bigInt/BigInteger, which is an imported dependency,
    and not a system-level affordance
  - everything should just use the system-level afforance,
    and in contexts where it's not available, they can pull in a polyfill themselves
  - to do this, just remove the dependency/import and start using system stuff
  - everything should be hit by tests, so easy to verify things still are correct
- make spider compatible
  - do the todos in /app/spider
    - respect content-type header on PUT request,
    - determine whether to sound noun or json result somehow
  - make thread() nounified
  - supply a threadWithJson() or w/e, similar to scryForJson()
- go over all the types, clean up unused ones
- do pre-release
- do webterm migration stream/recording
